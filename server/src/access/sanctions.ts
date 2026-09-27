import { accessCheck, accessMode, classGroupOfStudent, studentTarget } from './policy.js';

/**
 * The sanction ladder (plan §10 "Discipline sanctions") as capabilities.
 *
 * Legacy behaviour: anyone who could log (DISCIPLINE_LOG / DISCIPLINE_ADJUST)
 * or review (DISCIPLINE_REVIEW) could set any sanction, suspension included.
 * Under v2 each rung needs its own capability at the student's class group.
 *
 * DISCIPLINE_SUSPEND_RECOMMEND has no flow here yet: there is no
 * "recommended" sanction state, so setting `suspension` is always the
 * approval step and needs DISCIPLINE_SUSPEND_APPROVE.
 */
export const SANCTION_CAPABILITY: Record<string, string | null> = {
  none: null,
  warning: 'DISCIPLINE_SANCTION_MINOR',
  parent_contact: 'DISCIPLINE_SANCTION_MINOR',
  detention: 'DISCIPLINE_SANCTION_MAJOR',
  community_service: 'DISCIPLINE_SANCTION_MAJOR',
  counseling: 'DISCIPLINE_SANCTION_MAJOR',
  suspension: 'DISCIPLINE_SUSPEND_APPROVE',
};

export const sanctionCapability = (sanction: string | null | undefined) =>
  sanction ? SANCTION_CAPABILITY[sanction] ?? null : null;

/**
 * May the user apply `sanction` to these students? Only checked when the
 * sanction actually changes to something other than "none". Off: always
 * true. Shadow: true, disagreement recorded. Enforce: the v2 verdict.
 * Returns the capability that failed, or null when allowed.
 */
export async function sanctionDenied(
  req: any,
  sanction: string | null | undefined,
  studentIds: string[],
  previous?: string | null
): Promise<string | null> {
  const cap = sanctionCapability(sanction);
  if (!cap || sanction === previous || accessMode() === 'off') return null;
  for (const studentId of studentIds) {
    const ok = await accessCheck(req, cap, async () => studentTarget(studentId, await classGroupOfStudent(req, studentId)), {
      route: `SANCTION ${sanction}`,
    });
    if (!ok) return cap;
  }
  return null;
}

export function sanctionForbidden(res: any, cap: string) {
  return res.status(403).json({
    success: false,
    code: 'SANCTION_NOT_PERMITTED',
    message: `You are not permitted to apply this sanction to this student (${cap}).`,
  });
}
