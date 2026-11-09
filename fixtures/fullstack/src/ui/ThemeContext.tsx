import { createContext, useContext } from '../lib/fake-libs'

export const ThemeContext = createContext('light')

export function ThemeProvider({ children }: { children?: unknown }) {
  return <ThemeContext.Provider value="dark">{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
