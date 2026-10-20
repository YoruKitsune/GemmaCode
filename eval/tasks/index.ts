import type { EvalTask, Suite } from '../types.ts';
import { EDIT30 } from './edit30.ts';
import { GEN20 } from './gen20.ts';

export const SUITES: Record<Suite, EvalTask[]> = { edit30: EDIT30, gen20: GEN20 };
export const ALL_TASKS: EvalTask[] = [...EDIT30, ...GEN20];
