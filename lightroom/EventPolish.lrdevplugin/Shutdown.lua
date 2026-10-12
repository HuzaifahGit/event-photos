local LrTasks = import "LrTasks"
return {
	LrShutdownFunction = function(doneFunction, progressFunction)
		LrTasks.startAsyncTask(function()
			require("Bridge").stop()
			progressFunction(1)
			doneFunction()
		end)
	end,
}
