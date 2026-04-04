import { z } from 'zod';

// Magic Link Request Validation
export const magicLinkRequestSchema = z.object({
  email: z.string().email('Invalid email format').max(255, 'Email too long'),
});

// HEXACO Response Validation (1-5 scale)
export const hexacoResponseSchema = z.object({
  id: z.number().int().min(1).max(60),
  response: z.number().int().min(1).max(5),
});

// DASS-21 Response Validation (0-3 scale)
export const dassResponseSchema = z.object({
  id: z.number().int().min(1).max(21),
  response: z.number().int().min(0).max(3),
});

// TEIQue-SF Response Validation (1-7 scale)
export const teiqueResponseSchema = z.object({
  id: z.number().int().min(1).max(30),
  response: z.number().int().min(1).max(7),
});

// Complete Assessment Data Validation
export const assessmentDataSchema = z.object({
  dassScores: z.object({
    Depression: z.number().int().min(0).max(42),
    Anxiety: z.number().int().min(0).max(42),
    Stress: z.number().int().min(0).max(42),
  }),
  hexacoScores: z.object({
    HonestyHumility: z.number().min(0).max(5),
    Emotionality: z.number().min(0).max(5),
    Extraversion: z.number().min(0).max(5),
    Agreeableness: z.number().min(0).max(5),
    Conscientiousness: z.number().min(0).max(5),
    OpennessToExperience: z.number().min(0).max(5),
  }),
  teiqueScores: z.object({
    Wellbeing: z.number().min(0).max(7),
    SelfControl: z.number().min(0).max(7),
    Emotionality: z.number().min(0).max(7),
    Sociability: z.number().min(0).max(7),
    GlobalEI: z.number().min(0).max(7),
  }).optional(),
  rawResponses: z.object({
    dass: z.array(z.number().int().min(0).max(3)).length(21),
    hexaco: z.array(z.number().int().min(1).max(5)).length(60),
    teique: z.array(z.number().int().min(1).max(7)).length(30).optional(),
  }).optional(),
});

// Analyze Endpoint Request Validation
export const analyzeRequestSchema = z.object({
  assessmentData: assessmentDataSchema,
});

export const submitRequestSchema = z.object({
  email: z.string().email('Invalid email format').max(255, 'Email too long'),
  assessmentData: assessmentDataSchema,
  teamCode: z.string().max(20).optional(),
});

// Type exports for use in routes
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;
export type HEXACOResponse = z.infer<typeof hexacoResponseSchema>;
export type DASSResponse = z.infer<typeof dassResponseSchema>;
export type TEIQueResponse = z.infer<typeof teiqueResponseSchema>;
export type AssessmentData = z.infer<typeof assessmentDataSchema>;
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

// Validation helper
export function validateRequest<T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errorMessages = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  return { success: false, error: errorMessages };
}
