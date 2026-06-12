const userAgent = process.env.npm_config_user_agent || '';

if (!userAgent.startsWith('pnpm/')) {
  console.error('This repository uses pnpm only. Run commands through corepack pnpm.');
  process.exit(1);
}
