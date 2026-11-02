import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Served at the root of its own site: https://dorai-bd.pages.dev
// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [react()],
})
