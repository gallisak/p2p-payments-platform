import { AuthForm, AuthLink } from '@/components/auth-form';

export default function RegisterPage() {
  return (
    <AuthForm
      endpoint="/api/auth/register"
      title="Create an account"
      description="Your password needs at least 8 characters"
      submitLabel="Create account"
      failure="Could not create the account"
      footer={
        <>
          Already registered? <AuthLink href="/login">Sign in</AuthLink>
        </>
      }
    />
  );
}
