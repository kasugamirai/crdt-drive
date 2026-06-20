import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// base './' so the built dist/ also works when opened from the filesystem
export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
  server: { open: true },
})
