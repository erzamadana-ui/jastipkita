import type { Db } from '../db/sql';

export type RiskSubject = 'USER' | 'TRANSACTION' | 'PAYMENT' | 'REFERRAL' | 'REFUND' | 'PURCHASE_PROOF' | 'TRIP';

export interface RiskResultLike {
  score: number;
  decision: 'ALLOW' | 'REVIEW' | 'HOLD' | 'BLOCK';
  reasons: readonly { code: string; weight?: number; message?: string }[];
}

/**
 * Persists a risk assessment (from @jastipkita/core assessRisk / assessReceipt) and opens a manual
 * review for REVIEW/HOLD/BLOCK decisions. Returns the assessment id.
 */
export async function recordRiskAssessment(
  db: Db,
  subjectType: RiskSubject,
  subjectId: string,
  result: RiskResultLike,
  signals: Record<string, unknown>,
  rulesVersion = 'core-v1',
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO risk_assessments (subject_type, subject_id, score, decision, reasons, signals, rules_version)
    VALUES (${subjectType}, ${subjectId}, ${Math.round(result.score)}, ${result.decision},
            ${db.json(result.reasons as never)}, ${db.json(signals as never)}, ${rulesVersion})
    RETURNING id`;
  if (result.decision !== 'ALLOW') {
    await db`INSERT INTO risk_reviews (assessment_id, subject_type, subject_id, status) VALUES (${row!.id}, ${subjectType}, ${subjectId}, 'OPEN')`;
  }
  return row!.id;
}
