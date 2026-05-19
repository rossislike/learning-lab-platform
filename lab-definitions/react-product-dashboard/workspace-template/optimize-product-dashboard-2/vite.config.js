import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      // babel: {
      //   plugins: [['babel-plugin-react-compiler', {}]],
      // },
    }),
    tailwindcss()
  ],
  test: {
    include: ['tests/*.test.{js,jsx}'],
    environment: 'jsdom',
    setupFiles: 'setupTests.js',
    globals: true,
  },
})
