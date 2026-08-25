export default {
  manifest: {
    id: 'cpa.fixture.project',
    name: 'Fixture Project Plugin',
    version: '1.0.0',
    apiVersion: '1.0.0',
    engines: { cpa: '>=1.0.0' },
  },
  activate(context) {
    const bundledService = context.getService('bundledService')
    context.register({
      kind: 'service',
      id: 'projectService',
      value: {
        source: 'project',
        bundledPong: bundledService ? bundledService.ping() : undefined,
      },
    })
    context.registerAgentTool?.({
      name: 'fixture_project_tool',
      description: 'Fixture project tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, result: 'fixture-project-tool-ok' }),
    })
  },
  deactivate() {},
}
