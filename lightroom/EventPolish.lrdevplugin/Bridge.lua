--[[ EVENT Polish job runner (file-based: more robust than LrSocket).

Folder: ~/Library/Application Support/EventPolish/
  jobs/<id>.job      written by polish.py: a Lua table literal {cmd="polish", args={...}}
  jobs/<id>.result   written here: JSON {"ok":true,"result":{...}} / {"ok":false,"error":"..."}
  heartbeat.json     rewritten every second while Lightroom + this plug-in run
One job at a time, oldest first. Nothing to connect, so nothing to drop.
]]
local LrApplication = import "LrApplication"
local LrFileUtils = import "LrFileUtils"
local LrLogger = import "LrLogger"
local LrPathUtils = import "LrPathUtils"
local LrTasks = import "LrTasks"
local Json = require "Json"

local log = LrLogger("EventPolish")
log:enable("logfile")

local STATE_DIR = LrPathUtils.child(LrPathUtils.getStandardFilePath("home"), "Library/Application Support/EventPolish")
local JOBS = LrPathUtils.child(STATE_DIR, "jobs")
local HEARTBEAT = LrPathUtils.child(STATE_DIR, "heartbeat.json")
local OWNER = LrPathUtils.child(STATE_DIR, "owner.txt")   -- id of the one loop allowed to run

local function readOwner()
	local f = io.open(OWNER, "r")
	local v = f and f:read("*a") or ""
	if f then f:close() end
	return v
end

local Bridge = {}

-- Lightroom's Lua has no os.remove/os.rename: use LrFileUtils.
local function writeFile(path, text)
	local tmp = path .. ".tmp"
	local f = io.open(tmp, "w")
	if not f then return end
	f:write(text); f:close()
	if LrFileUtils.exists(path) then LrFileUtils.delete(path) end
	LrFileUtils.move(tmp, path)
end

local function loadHandlers()
	local chunk, err = loadfile(_PLUGIN.path .. "/Handlers.lua")   -- re-read: live edits
	if chunk then return chunk() end
	log:warn("Handlers.lua: " .. tostring(err))
	return require "Handlers"
end

local function runJob(jobPath)
	-- the job logic lives in Handlers.lua, re-read for every job, so fixes
	-- there apply without reloading the plug-in
	local H = loadHandlers()
	if H.runJob then return H.runJob(jobPath, writeFile) end
	error("Handlers.lua has no runJob")
end

function Bridge.status() return _G.EVENT_running and "running" or "stopped" end
function Bridge.stop() _G.EVENT_running = false; _G.EVENT_gen = (_G.EVENT_gen or 0) + 1 end

-- Safe to call again (plug-in reload): a newer start retires the older loop.
function Bridge.start()
	_G.EVENT_gen = (_G.EVENT_gen or 0) + 1
	local gen = _G.EVENT_gen
	_G.EVENT_running = true
	LrFileUtils.createAllDirectories(JOBS)
	-- claim ownership: any older loop (even from a previous plug-in load, which
	-- lives in a different Lua environment) sees a new owner and exits
	local me = tostring(os.time()) .. "-" .. tostring(math.random(1e9))
	writeFile(OWNER, me)
	log:info("job runner started (" .. me .. "), watching " .. JOBS)
	LrTasks.startAsyncTask(function()
		while _G.EVENT_running and _G.EVENT_gen == gen and readOwner() == me do
			writeFile(HEARTBEAT, Json.encode({ t = os.time(), version = LrApplication.versionString(),
				busy = _G.EVENT_current ~= nil }))
			local jobs = {}
			for path in LrFileUtils.files(JOBS) do
				if path:match("%.job$") then jobs[#jobs + 1] = path end
			end
			table.sort(jobs)                                  -- names start with a timestamp
			if jobs[1] then
				local ok, err = LrTasks.pcall(runJob, jobs[1])
				if not ok then
					log:error("job runner: " .. tostring(err))
					-- always answer, so the Mac side never waits blindly
					writeFile(jobs[1]:gsub("%.job$", ".result"), Json.encode({ ok = false, error = tostring(err) }))
					if LrFileUtils.exists(jobs[1]) then LrFileUtils.delete(jobs[1]) end
				end
			else
				LrTasks.sleep(1)
			end
		end
		log:info("job runner stopped (" .. me .. ")")
	end)
end

return Bridge
