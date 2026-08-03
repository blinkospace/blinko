export type PasswordUpdateError = 'required' | 'mismatch'

export const preparePasswordUpdate = (
  id: number,
  originalPassword: string,
  password: string,
  passwordConfirm: string
) => {
  if (!originalPassword || !password || !passwordConfirm) {
    return { error: 'required' as const }
  }

  if (password !== passwordConfirm) {
    return { error: 'mismatch' as const }
  }

  return {
    input: {
      id,
      originalPassword,
      password
    }
  }
}
