// Choose the native executor within this preset's scope. Never inherit a
// deployment-wide executor when a compatible scoped native API is missing.
export async function selectNativeToolMode(ctx, loadNativeExecutor) {
  if (typeof ctx.tools?.presentAs === 'function') {
    ctx.tools.presentAs('native');
    return;
  }
  if (typeof ctx.tools?.setExecutor !== 'function' || typeof loadNativeExecutor !== 'function') {
    throw new Error('A scoped native DSH tool executor is unavailable.');
  }
  const { NativeToolExecutor } = await loadNativeExecutor();
  if (typeof NativeToolExecutor !== 'function') throw new Error('The DSH native tool executor is unavailable.');
  const executor = new NativeToolExecutor(ctx);
  if (typeof executor.describe !== 'function' || typeof executor.execute !== 'function') {
    throw new Error('The DSH native tool executor contract is invalid.');
  }
  ctx.tools.setExecutor(executor);
}
