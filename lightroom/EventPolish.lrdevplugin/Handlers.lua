--[[ EVENT Polish command handlers (re-read from disk on every command).
  ping                                          -> Lightroom version, catalog
  polish {path, denoise, amount, dir, maxSize, quality}
      import RAW (Add, never moves) -> Develop -> Auto tone -> [AI Denoise]
      -> export JPEG (sRGB) -> {file, seconds, denoised}
]]
local LrApplication = import "LrApplication"
local LrApplicationView = import "LrApplicationView"
local LrDevelopController = import "LrDevelopController"
local LrExportSession = import "LrExportSession"
local LrFileUtils = import "LrFileUtils"
local LrLogger = import "LrLogger"
local LrTasks = import "LrTasks"
local Json = require "Json"
local log = LrLogger("EventPolish")
log:enable("logfile")

local function catalog() return LrApplication.activeCatalog() end
local handlers = {}

-- Every edited photo is collected in this Lightroom collection.
local COLLECTION = "Event"
local function ensureCollection()
	local cat = catalog()
	local col
	cat:withWriteAccessDo("EVENT Polish: collection", function()
		col = cat:createCollection(COLLECTION, nil, true)   -- returns the existing one if present
	end, { timeout = 30 })
	return col
end

function handlers.setup()
	local col = ensureCollection()
	return { collection = col and col:getName() or COLLECTION }
end

function handlers.ping()
	return { version = LrApplication.versionString(), catalog = catalog():getPath() }
end

local function importPhoto(path)
	local cat = catalog()
	local photo = cat:findPhotoByPath(path)
	if not photo then
		cat:withWriteAccessDo("EVENT Polish: import", function() cat:addPhoto(path) end, { timeout = 60 })
		photo = cat:findPhotoByPath(path)
	end
	if not photo then error("import failed: " .. path) end
	return photo
end

local function openInDevelop(photo)
	local cat = catalog()
	for attempt = 1, 3 do                  -- first photo after start-up can be slow
		if attempt > 1 then LrApplicationView.switchToModule("library"); LrTasks.sleep(1) end
		cat:setActiveSources { cat.kAllPhotos }
		cat:setSelectedPhotos(photo, {})
		LrApplicationView.switchToModule("develop")
		for _ = 1, 120 do                  -- up to 30 s
			if cat:getTargetPhoto() == photo then LrTasks.sleep(0.8) return end
			LrTasks.sleep(0.25)
		end
		log:warn("Develop didn't show the photo yet (attempt " .. attempt .. ")")
	end
	error("could not open photo in Develop")
end

local function exportJpeg(photo, args)
	LrFileUtils.createAllDirectories(args.dir)
	local s = {
		LR_export_destinationType = "specificFolder",
		LR_export_destinationPathPrefix = args.dir,
		LR_export_useSubfolder = false,
		LR_collisionHandling = "overwrite",
		LR_reimportExportedPhoto = false,
		LR_renamingTokensOn = false,
		LR_useWatermark = false,
		LR_format = "JPEG",
		LR_jpeg_quality = args.quality or 0.85,
		LR_export_colorSpace = "sRGB",
		LR_outputSharpeningOn = true,
		LR_outputSharpeningMedia = "screen",
		LR_outputSharpeningLevel = 2,
		LR_metadata_keywordOptions = "lightroomHierarchical",
		LR_removeLocationMetadata = true,
		LR_size_doConstrain = true,
		LR_size_doNotEnlarge = true,
		LR_size_maxWidth = args.maxSize or 5000,
		LR_size_maxHeight = args.maxSize or 5000,
		LR_size_units = "pixels",
		LR_size_resizeType = "wh",
	}
	local session = LrExportSession { photosToExport = { photo }, exportSettings = s }
	session:doExportOnCurrentTask()
	for _, rendition in session:renditions() do
		local ok, pathOrMessage = rendition:waitForRender()
		if not ok then error("export failed: " .. tostring(pathOrMessage)) end
		return pathOrMessage
	end
	error("export produced no file")
end

function handlers.polish(args)
	local t0 = os.time()
	local expBefore, expAfter
	local photo = importPhoto(args.path)
	openInDevelop(photo)
	if not args.noAuto then
		LrDevelopController.setAutoTone()           -- Adobe "Auto" (Basic panel)
		LrTasks.sleep(1.0)
	end
	if args.exposure and args.exposure ~= 0 then    -- relight.py: extra stops on top of Auto
		LrTasks.sleep(1.5)                          -- let Auto settle and save first
		expBefore = photo:getDevelopSettings().Exposure2012 or 0
		local ev = math.max(-5, math.min(5, expBefore + args.exposure))
		local set = { Exposure2012 = ev }
		if args.highlights then                     -- hold back bright shirts/screens when lifting
			set.Highlights2012 = math.min(photo:getDevelopSettings().Highlights2012 or 0, args.highlights)
		end
		catalog():withWriteAccessDo("EVENT Polish: exposure", function()
			photo:applyDevelopSettings(set)
		end, { timeout = 30 })
		LrTasks.sleep(0.8)
		expAfter = photo:getDevelopSettings().Exposure2012
	end
	local denoised = false
	if args.denoise then
		local st = LrDevelopController.getEnhancePanelState()
		if st.denoiseEnabled then
			LrDevelopController.setEnhance("denoise", true, args.amount or 50)
			for i = 1, 600 do                            -- up to 5 min
				LrTasks.sleep(0.5)
				st = LrDevelopController.getEnhancePanelState()
				if st.denoiseState and not st.enhanceNeedsUpdate and i > 2 then break end
			end
			denoised = true
		else
			log:warn("denoise unavailable: " .. tostring(st.denoiseInfoText))
		end
	end
	local col = ensureCollection()
	catalog():withWriteAccessDo("EVENT Polish: tag", function()
		if col then col:addPhotos { photo } end
		photo:setPropertyForPlugin(_PLUGIN, "polish",
			"Adobe Auto" .. ((args.exposure and args.exposure ~= 0) and string.format(" %+.2f EV", args.exposure) or "") .. (denoised and " + AI Denoise" or "") .. (args.iso and (" · ISO " .. tostring(args.iso)) or ""))
	end, { timeout = 30 })
	local file = exportJpeg(photo, args)
	return { file = file, seconds = os.time() - t0, denoised = denoised, expBefore = expBefore, expAfter = expAfter }
end


-- One job file -> handler -> result file (called by Bridge.lua's loop).
local function runJob(jobPath, writeFile)
	local resultPath = jobPath:gsub("%.job$", ".result")
	local f = io.open(jobPath, "r")
	local text = f and f:read("*a") or ""
	if f then f:close() end
	LrFileUtils.delete(jobPath)
	local out
	local chunk, perr = loadstring("return " .. text)
	if not chunk then
		out = { ok = false, error = "bad job: " .. tostring(perr) }
	else
		if setfenv then setfenv(chunk, {}) end              -- data only (where available)
		local okParse, req = pcall(chunk)
		local h = okParse and type(req) == "table" and handlers[req.cmd]
		if not h then
			out = { ok = false, error = "unknown job: " .. tostring(okParse and type(req) == "table" and req.cmd) }
		else
			_G.EVENT_current = req.cmd
			local ok, res = LrTasks.pcall(h, req.args or {})
			_G.EVENT_current = nil
			out = ok and { ok = true, result = res } or { ok = false, error = tostring(res) }
			log:info(string.format("job %s %s", tostring(req.cmd), ok and "ok" or ("failed: " .. tostring(res))))
		end
	end
	writeFile(resultPath, Json.encode(out))
end

return { handlers = handlers, runJob = runJob }
