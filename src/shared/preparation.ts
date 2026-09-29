import { z } from 'zod'

export const preparationRequestSchema = z.object({ planId: z.string().uuid() }).strict()
export type PreparationItem = {
  id: number
  action: 'extract' | 'rename' | 'cleanup'
  source: string
  target: string | null
  size: number
  note: string
}
export type PreparationPlan = {
  id: string
  createdAt: number
  download: string
  preprocess: string
  items: PreparationItem[]
  cleanupDirectories: string[]
  warnings: string[]
}
export type PreparationState = {
  id: string
  status: 'running' | 'cancelling' | 'succeeded' | 'cancelled' | 'failed'
  completed: number
  total: number
  message: string
  startedAt: string
  endedAt?: string
  journal: string
}
