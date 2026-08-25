import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'

/**
 * Root UI entry once providers are ready: mounts the app router.
 */
export function App() {
  return <RouterProvider router={router} />
}

export default App
