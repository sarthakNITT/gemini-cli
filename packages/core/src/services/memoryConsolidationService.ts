/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
import type { Content } from '@google/genai';
import { debugLogger } from '../utils/debugLogger.js';
import { LlmRole } from '../telemetry/types.js';

const MICRO_CONSOLIDATION_PROMPT = `
You are the background subconscious memory module of an autonomous engineering agent.
Your task is to extract a single, highly condensed factual takeaway from the immediately preceding interaction turn.

Rules:
1. Ignore conversational filler, pleasantries, or planning. Focus STRICTLY on hard technical facts, file paths discovered, tool outcomes (especially errors), or immediate workarounds.
2. If the turn was a failure or error, note what failed and the root cause if known.
3. If the turn was a success, note the successful path, command, or location of logic.
4. Output MUST be a single concise bullet point (max 1-2 sentences).
5. Do NOT output markdown formatting like \`\`\` or bold text, just the raw text of the bullet point.
6. If the interaction contains NO hard technical facts, outcomes, or errors (e.g., just conversational filler or planning), output exactly: NO_SIGNIFICANT_FACTS

Example Outputs:
- \`npm run build\` failed because of a missing dependency \`chalk\` in packages/cli/package.json.
- Found the user authentication logic in src/auth/login.ts; it uses JWT.
- Attempted to use the \`replace\` tool on file.txt but failed due to mismatched whitespace.
- NO_SIGNIFICANT_FACTS
`.trim();

export class MemoryConsolidationService {
  constructor(private readonly config: Config) {}

  /**
   * Triggers a fire-and-forget background task to summarize the latest turn.
   */
  triggerMicroConsolidation(latestTurnContext: Content[]): void {
    if (!this.config.getIsForeverMode()) {
      return;
    }

    if (latestTurnContext.length === 0) {
      return;
    }

    // Fire and forget
    void this.performConsolidation(latestTurnContext).catch((err) => {
      // Subconscious failures should not block the main thread, only log to debug
      debugLogger.error('Micro-consolidation failed (non-fatal)', err);
    });
  }

  private async performConsolidation(
    latestTurnContext: Content[],
  ): Promise<void> {
    const baseClient = this.config.getBaseLlmClient();

    // Force the use of gemini-3-flash-preview for micro-consolidation
    const modelAlias = 'gemini-3-flash-preview';

    try {
      // Serialize the context to avoid Gemini API 400 errors regarding functionCall/functionResponse turn sequence
      const serializedContext = JSON.stringify(latestTurnContext);

      const response = await baseClient.generateContent({
        modelConfigKey: { model: modelAlias, isChatModel: false },
        contents: [
          {
            role: 'user',
            parts: [{ text: serializedContext }],
          },
        ],
        systemInstruction: MICRO_CONSOLIDATION_PROMPT,
        abortSignal: new AbortController().signal,
        promptId: `micro-consolidation-${Date.now()}`,
        role: LlmRole.UTILITY_SUMMARIZER,
        maxAttempts: 1, // Disable retries for this background task
      });

      const fact = response.text?.trim();

      if (fact && fact !== 'NO_SIGNIFICANT_FACTS') {
        const knowledgeDir = this.config.storage.getKnowledgeDir();
        await fs.mkdir(knowledgeDir, { recursive: true });

        const hippocampusPath = path.join(knowledgeDir, 'hippocampus.md');

        // Append to the file with a timestamp for chronological tracking
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
        const logEntry = `[${timestamp}] - ${fact}\n`;

        await fs.appendFile(hippocampusPath, logEntry);
      }
    } catch (e) {
      debugLogger.error('Failed to run micro-consolidation', e);
    }
  }
}
