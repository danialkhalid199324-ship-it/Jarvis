/// <reference types="vite/client" />
import type { JarvisApi } from '../preload/index'

declare global {
  interface Window {
    jarvis: JarvisApi
  }
}

export {}
