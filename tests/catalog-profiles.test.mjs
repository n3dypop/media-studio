import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG_PROFILES,buildCatalogGraph,catalogModels,validateCatalogGraph} from '../apps/controller/catalog-profiles.mjs';
import {assertModeProfile,mediaIntent,preparedParameters} from '../apps/controller/media-modes.mjs';

const owned=index=>{
  const id=`11111111-1111-4111-8111-11111111111${index}`;
  return {id,comfyInputName:`controller-assets/${'a'.repeat(24)}/${id}-${'b'.repeat(64)}.png`};
};

test('catalog profiles pin model, operation, generator bindings and output',()=>{
  for(const [modelProfile,definition] of Object.entries(CATALOG_PROFILES)){
    const {mode,inputs}=definition,inputAssets=Array.from({length:inputs},(_,i)=>owned(i+1));
    const request={modelProfile,mode,prompt:'A ceramic cup',inputAssets,width:512,height:512};
    assert.doesNotThrow(()=>assertModeProfile(mode,modelProfile));
    assert.throws(()=>assertModeProfile(mode==='t2i'?'edit':'t2i',modelProfile),{status:400});
    assert.doesNotThrow(()=>mediaIntent({modelProfile,mode,inputAssetIds:inputAssets.map(a=>a.id)}));
    const {graph,output,parameters}=buildCatalogGraph(request);
    assert.deepEqual(validateCatalogGraph(graph,request).output,output);
    assert.deepEqual(preparedParameters({schemaVersion:6,mode,request:parameters,output}),parameters);
    assert(catalogModels(graph).length>0);
    assert.throws(()=>validateCatalogGraph({...graph,save:{...graph.save,inputs:{...graph.save.inputs,filename_prefix:'arbitrary/path'}}},request),/differs/);
    if(inputs)assert.throws(()=>buildCatalogGraph({...request,inputAssets:[{comfyInputName:'unowned.png'}]}),/owned/);
  }
});
