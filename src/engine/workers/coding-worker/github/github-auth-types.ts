export type GithubAuthState =
  | 'unknown'
  | 'unauthenticated'
  | 'authorization_pending'
  | 'verifying'
  | 'authenticated'
  | 'invalid'
  | 'expired'
  | 'cancelled'
  | 'interrupted'
  | 'failed';

export type GithubCredentialSource = 'gh_token' | 'github_token' | 'managed_profile' | 'none';

export interface GithubAuthProfileRef {
  profile?: string;
}

export interface GithubAuthResult {
  state: GithubAuthState;
  profile: string;
  hostname: 'github.com';
  credentialSource: GithubCredentialSource;
  authSessionId?: string;
  accountLogin?: string;
  scopes?: string[];
  gitProtocol?: 'https';
  expiresAt?: string;
  checkedAt: string;
  failureCode?: string;
}
