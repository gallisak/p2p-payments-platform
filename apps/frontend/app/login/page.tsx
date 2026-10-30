import { AuthForm, AuthLink } from '@/components/auth-form';

export default function LoginPage() {
  return (
    <AuthForm
      endpoint="/api/auth/login"
      title="Sign in"
      description="Enter your email and password"
      submitLabel="Sign in"
      failure="Could not sign in"
      footer={
        <>
          No account yet? <AuthLink href="/register">Create one</AuthLink>
        </>
      }
    />
  );
}
