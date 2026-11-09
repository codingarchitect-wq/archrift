// The arc42 views (one plug-in per arc42 section, src/viewer/views/<id>/):
// what each section is called, what it answers, and what of it the code
// can't tell. They share the toolbar menu `arc42` (ViewPlugin.group).

export const ARC42 = 'arc42'

export type Arc42Section = 'context' | 'blocks' | 'runtime' | 'crosscutting' | 'risks'

export interface SectionInfo {
  /** The arc42 chapter. */
  number: number
  /** Its arc42 title. */
  title: string
  /** In the toolbar menu and on its button. */
  label: string
  /** The plug-in's toolbar order: after the other views, in chapter order. */
  order: number
  /** What the section answers, in a sentence. */
  about: string
  /** What the code can't tell, which the view says plainly. */
  limits: string
}

export const SECTIONS: Record<Arc42Section, SectionInfo> = {
  context: {
    number: 3,
    title: 'Context and Scope',
    label: '§3 Context',
    order: 103,
    about: 'What the system exchanges with its neighbors (users, outside systems, data stores) and through which channels.',
    limits: 'The technical context, as found in the code. Who the actors are and why they come needs your input.',
  },
  blocks: {
    number: 5,
    title: 'Building Block View',
    label: '§5 Building blocks',
    order: 105,
    about: 'The static decomposition: building blocks as black boxes and their relationships, each opened into its white box one level down.',
    limits: 'Blocks are folders (or the toolbar’s grouping). What each one is responsible for needs your words.',
  },
  runtime: {
    number: 6,
    title: 'Runtime View',
    label: '§6 Runtime',
    order: 106,
    about: 'How the building blocks work together in one scenario: the calls it makes, in order.',
    limits: 'From the static calls in source order. Which branch runs, and how often, the code alone doesn’t tell.',
  },
  crosscutting: {
    number: 8,
    title: 'Crosscutting Concepts',
    label: '§8 Crosscutting',
    order: 108,
    about: 'Concerns that many building blocks share, such as auth, translations, persistence or validation.',
    limits: 'Candidates, found by how widely code is used across blocks. Naming the concept and its rules is yours.',
  },
  risks: {
    number: 11,
    title: 'Risks and Technical Debt',
    label: '§11 Risks & debt',
    order: 111,
    about: 'Where change is likely and costly, and the debt the code carries, highest priority first.',
    limits: 'From the history and the structure. Business and project risks need your input.',
  },
}
