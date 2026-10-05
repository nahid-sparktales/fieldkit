import { z } from "zod";

// Browser schemas use the runtime validator without probing dynamic code execution.
// Load before shared contracts so strict CSP never needs unsafe-eval.
z.config({ jitless: true });
