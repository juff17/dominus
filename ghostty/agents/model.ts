// Re-exports the agent model. A module that needs only one part imports that
// part directly, so it loads less; the tray's snapshot does.

export { addEntry, emptyTranscript, eventTag, parseNotification } from './transcript.ts'
export type { MonitorEvent, ToolCall, Transcript } from './transcript.ts'
export type { Pane, Session, Subagent } from './daemon.ts'
export {
  askingAbout,
  attentionTags,
  brokeTags,
  classify,
  describeTool,
  monitorKind,
  monitorProcess,
  pairParked,
  repoOf,
} from './classify.ts'
export { permissionTool, showsPermission } from './permission.ts'
export type { Agent, AgentKind, AgentState, Monitor, MonitorState, Need, Proc } from './classify.ts'
export { cardHeights, counts, lanes, monitorsOf, scrollTo, watches } from './board.ts'
export type { Counts, Lane, Lanes, StripMonitor } from './board.ts'
export { launch, slug } from './launch.ts'
export type { LaunchPlan, LaunchSpec, MonitorSpec, TaskSpec, TicketSpec } from './launch.ts'
