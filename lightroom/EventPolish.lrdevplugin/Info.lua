-- EVENT Polish: auto-edits Event Photos camera RAWs with Adobe Auto (+ AI Denoise
-- on high-ISO shots) and exports a JPEG for the event gallery. Driven by the
-- event-photos polish worker (polish.py) over a local socket (Bridge.lua).
return {
	LrSdkVersion = 12.0,
	LrSdkMinimumVersion = 10.0,
	LrToolkitIdentifier = "com.example.eventpolish",
	LrPluginName = "EVENT Polish",
	LrInitPlugin = "Init.lua",
	LrForceInitPlugin = true,          -- start the socket server when Lightroom starts
	LrShutdownPlugin = "Shutdown.lua",
	LrDisablePlugin = "Stop.lua",
	LrMetadataProvider = "EventMetadata.lua",   -- also makes Lightroom start the plug-in with the catalog
	VERSION = { major = 0, minor = 1, revision = 0 },
}
