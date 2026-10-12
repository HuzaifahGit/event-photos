-- Shows what EVENT Polish did to each photo in Lightroom's Metadata panel
-- ("All Plug-in Metadata"). Having a metadata provider also makes Lightroom
-- load this plug-in (and start its bridge) as soon as the catalog opens.
return {
	metadataFieldsForPhotos = {
		{ id = "polish", title = "EVENT Polish", dataType = "string", readOnly = true, searchable = true, browsable = true },
	},
	schemaVersion = 1,
}
