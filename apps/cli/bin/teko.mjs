#!/usr/bin/env node
// Carrega o TypeScript direto (tsx), sem etapa de build.
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
