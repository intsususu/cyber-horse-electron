import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { devCsp } from './config/dev-csp'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), devCsp()],
    server: { host: '127.0.0.1' },
    build: { minify: true },
  },
})
