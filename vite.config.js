import { defineConfig } from 'vite'

// base './' so the built dist/ also works when opened from the filesystem
export default defineConfig({
  base: './',
  plugins: [],
  server: { open: true },
})
