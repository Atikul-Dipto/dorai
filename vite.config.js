import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Served as a sub-page of the portfolio: atikul-dipto.github.io/price-pulse/
// https://vite.dev/config/
export default defineConfig({
  base: '/price-pulse/',
  plugins: [react()],
})
