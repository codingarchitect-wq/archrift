export function useCounter(start = 0) {
  let n = start
  return { inc: () => ++n, get: () => n }
}
