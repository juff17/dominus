// Reading /proc: a process's stat fields, start time, parent and argv.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The fields after a /proc/<pid>/stat's command name, which can hold spaces
// and parens, so it's cut at the last ')'. Index 1 is the parent pid, 19 the
// start time (fields 4 and 22 of the whole line).
export const statFields = (stat: string): string[] => stat.slice(stat.lastIndexOf(')') + 2).split(' ')
export const procStart = (stat: string): string => statFields(stat)[19]
export const parentPid = (stat: string): number => Number(statFields(stat)[1])

export const readStat = (pid: number): string => readFileSync(`/proc/${pid}/stat`, 'utf8')
// A process's argv, its NULs as spaces.
export const readCmdline = (pid: number | string, dir = '/proc'): string => readFileSync(join(dir, String(pid), 'cmdline'), 'utf8').replaceAll('\0', ' ')
