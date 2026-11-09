export const buttonVariants = { default: 'btn', outline: 'btn btn-outline' }

export function Button({ children }: { children: unknown }) {
  return <button className={buttonVariants.default}>{children}</button>
}
