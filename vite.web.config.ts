import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devCsp } from './config/dev-csp'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), devCsp()],
  server: { port: 5173, strictPort: true },
})
