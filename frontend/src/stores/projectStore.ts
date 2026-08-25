import { create } from 'zustand'
import { createId } from '@/lib/id'
import { createProjectPathsPatch } from '@/lib/projectPaths'
import type { Project } from '@/types/models'

interface ProjectState {
  projects: Project[]
  addProject: (input: { id?: string; name: string; path?: string; paths?: string[] }) => string
  updateProject: (
    id: string,
    patch: Partial<
      Pick<
        Project,
        | 'name'
        | 'path'
        | 'paths'
        | 'pinned'
        | 'setupScript'
        | 'cleanupScript'
        | 'setupScripts'
        | 'cleanupScripts'
        | 'setupPlatform'
        | 'cleanupPlatform'
        | 'actions'
        | 'workLocation'
        | 'environmentId'
      >
    >,
  ) => void
  removeProject: (id: string) => void
  togglePin: (id: string) => void
  hydrate: (projects: Project[]) => void
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],

  addProject: (input) => {
    const now = Date.now()
    const id = input.id || createId()
    const pathPatch = createProjectPathsPatch(
      input.paths ?? (input.path ? [input.path] : []),
    )
    const project: Project = {
      id,
      name: input.name,
      ...pathPatch,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      projects: [project, ...state.projects],
    }))
    return id
  },

  updateProject: (id, patch) =>
    set((state) => {
      const exists = state.projects.some((project) => project.id === id)
      if (exists) {
        return {
          projects: state.projects.map((project) =>
            project.id === id
              ? { ...project, ...patch, updatedAt: Date.now() }
              : project,
          ),
        }
      }
      const now = Date.now()
      const newProject: Project = {
        id,
        name: patch.name ?? id,
        pinned: patch.pinned ?? false,
        createdAt: now,
        updatedAt: now,
        ...patch,
      }
      return {
        projects: [newProject, ...state.projects],
      }
    }),

  removeProject: (id) =>
    set((state) => ({
      projects: state.projects.filter((project) => project.id !== id),
    })),

  togglePin: (id) =>
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id
          ? { ...project, pinned: !project.pinned, updatedAt: Date.now() }
          : project,
      ),
    })),

  hydrate: (projects) => set({ projects }),
}))
