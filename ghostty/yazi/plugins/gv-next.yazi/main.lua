--- @sync entry
-- Tab in the viewer's Files mode (keymap.toml): quits plainly, for the next
-- mode. A click on a mode's tab leaves that mode's number in GV_NEXT_MARK
-- before it quits (init.lua); when that quit was called off (yazi asks first
-- while a task runs), the number would still be there, and bin/ghostty-viewer
-- would take this Tab for that click. So it goes first.
return {
	entry = function()
		local mark = os.getenv("GV_NEXT_MARK")
		if mark and mark ~= "" then
			os.remove(mark)
		end
		ya.emit("quit", {})
	end,
}
