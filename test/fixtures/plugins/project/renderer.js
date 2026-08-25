export default {
  manifest: {
    id: 'cpa.fixture.project',
    name: 'Fixture Project Plugin',
    version: '1.0.0',
    apiVersion: '1.0.0',
    engines: { cpa: '>=1.0.0' },
  },
  activate(context) {
    context.registerAction?.({
      id: 'fixture.project.action',
      title: 'Project Action',
      execute: () => 'project-action-executed',
    })
  },
  deactivate() {},
}
