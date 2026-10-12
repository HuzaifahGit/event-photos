-- Start the socket server, and create the "Event" collection right away.
local function mark(msg)   -- plain-file breadcrumb (works even if LrLogger doesn't)
	local f = io.open((_PLUGIN and _PLUGIN.path or ".") .. "/../event_polish_status.txt", "a")
	if f then f:write(os.date("%Y-%m-%d %H:%M:%S") .. "  " .. msg .. "\n"); f:close() end
end
mark("init start")
local ok, err = pcall(function()
	local LrLogger = import "LrLogger"
	local LrTasks = import "LrTasks"
	local log = LrLogger("EventPolish")
	log:enable("logfile")
	log:info("EVENT Polish init")
	require("Bridge").start()
	mark("bridge started")
	LrTasks.startAsyncTask(function()
		local ok2, err2 = LrTasks.pcall(function()
			dofile(_PLUGIN.path .. "/Handlers.lua").handlers.setup()
		end)
		mark("collection setup: " .. tostring(ok2) .. " " .. tostring(err2))
	end)
end)
mark("init done: " .. tostring(ok) .. " " .. tostring(err))
