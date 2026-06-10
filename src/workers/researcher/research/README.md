# Researcher Research Support

This directory contains support code owned by the researcher worker.

It is not a Flue agent entrypoint, workflow entrypoint, or shared top-level subsystem. Keep code here when it directly supports the researcher worker's source-backed web research behavior, such as research cache handling or web-provider wrappers.

Shared retrieval architecture stays outside this directory. Flue workflows may import this support code when running researcher-owned research operations.
