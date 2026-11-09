// Diagram kit: the diagram views (one plug-in each, src/viewer/views/<id>/),
// what each is called, what it answers and what the code can't tell. They
// share the toolbar menu `Diagrams` (ViewPlugin.group), after the arc42 one.

export const DIAGRAMS = 'Diagrams'

export type DiagramKind = 'erd' | 'classes'

export interface DiagramInfo {
  /** In the toolbar menu and on its button. */
  label: string
  /** On the board's caption and the legend's head. */
  title: string
  order: number
  about: string
  limits: string
}

export const DIAGRAM_INFO: Record<DiagramKind, DiagramInfo> = {
  erd: {
    label: 'Tables (ERD)',
    title: 'Entity–relationship diagram',
    order: 121,
    about: 'The tables of each database the code declares, their columns and keys, and the foreign keys between them.',
    limits: 'As the schema declares it (Prisma, Dexie, SQL migrations, JPA and Mongo entities). Keys enforced only in code don’t show.',
  },
  classes: {
    label: 'Classes',
    title: 'Class diagram',
    order: 122,
    about: 'Classes, interfaces, type aliases and enums with their members: a family joined by extends and implements, or the types of one folder.',
    limits: 'From declarations and their signatures. What a type is for, and associations held in local variables, the code doesn’t say.',
  },
}
