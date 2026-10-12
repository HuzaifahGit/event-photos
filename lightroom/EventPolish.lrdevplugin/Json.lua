-- Minimal JSON encoder (replies to Python). Commands from Python arrive as
-- Lua table literals, so no decoder is needed.
local Json = {}

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
                  ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }

local function encodeString(s)
	return '"' .. s:gsub('[%c"\\]', function(c)
		return escapes[c] or string.format("\\u%04x", c:byte())
	end) .. '"'
end

local function isArray(t)
	local n = 0
	for k in pairs(t) do
		if type(k) ~= "number" then return false end
		n = n + 1
	end
	return n == #t
end

function Json.encode(v)
	local t = type(v)
	if t == "nil" then return "null"
	elseif t == "boolean" then return tostring(v)
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return "null" end
		return string.format("%.10g", v)
	elseif t == "string" then return encodeString(v)
	elseif t == "table" then
		local parts = {}
		if next(v) ~= nil and isArray(v) then
			for _, x in ipairs(v) do parts[#parts + 1] = Json.encode(x) end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		for k, x in pairs(v) do
			parts[#parts + 1] = encodeString(tostring(k)) .. ":" .. Json.encode(x)
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	return encodeString(tostring(v))
end

return Json
