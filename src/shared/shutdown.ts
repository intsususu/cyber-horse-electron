import { z } from 'zod'

export const shutdownRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('timer'), minutes: z.number().int().min(1).max(720) }).strict(),
  z.object({ mode: z.literal('tasks') }).strict(),
])
export type ShutdownRequest = z.infer<typeof shutdownRequestSchema>
export type ShutdownState = {
  phase: 'idle' | 'waiting' | 'countdown' | 'executing' | 'requested' | 'failed'
  mode: ShutdownRequest['mode'] | null
  remainingSeconds: number | null
  message: string
  supported: boolean
  testMode: boolean
}
export interface ShutdownApi {
  getShutdownState(): Promise<ShutdownState>
  startShutdown(request: ShutdownRequest): Promise<ShutdownState>
  cancelShutdown(): Promise<ShutdownState>
}
