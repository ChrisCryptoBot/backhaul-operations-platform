import React from "react";

interface AuthErrorStateProps {
  title: string;
  description: string;
  hint?: string;
}

export function AuthErrorState({ title, description, hint }: AuthErrorStateProps) {
  return (
    <section className="db-auth-card db-auth-error" role="alert" aria-live="polite">
      <h1 className="db-auth-title">{title}</h1>
      <p className="db-auth-copy">{description}</p>
      {hint ? <p className="db-auth-hint mono">{hint}</p> : null}
    </section>
  );
}
