import { MAYA_INSTRUCTIONS } from "./maya.ts";
import { QUINN_INSTRUCTIONS } from "./quinn.ts";
import { SAM_INSTRUCTIONS } from "./sam.ts";
import { SUSIE_INSTRUCTIONS } from "./susie.ts";
import { THEO_INSTRUCTIONS } from "./theo.ts";

export const PERSONAS = {
  maya: MAYA_INSTRUCTIONS,
  theo: THEO_INSTRUCTIONS,
  sam: SAM_INSTRUCTIONS,
  quinn: QUINN_INSTRUCTIONS,
  susie: SUSIE_INSTRUCTIONS,
} as const;

export type PersonaName = keyof typeof PERSONAS;

export function selectPersona(text: string) {
  const match = /^\/(maya|theo|sam|quinn|susie)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return { name: "maya" as PersonaName, input: text, instructions: PERSONAS.maya };

  const name = match[1].toLowerCase() as PersonaName;
  return {
    name,
    input: match[2]?.trim() ?? "",
    instructions: PERSONAS[name],
  };
}
