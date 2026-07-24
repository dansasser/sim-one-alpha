# Security

Never publish or mutate remote GitHub state without approval. Do not expose tokens or credentials.

Do not configure SSH, host-global Git credential helpers, or arbitrary GitHub hosts/protocols. Do not start, cancel, or log out of a GitHub authentication session; the Coding Worker lead owns those lifecycle actions.
