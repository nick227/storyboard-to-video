const fs=require('node:fs');const path=require('node:path');const {AppError}=require('../errors');
function createAssetsController({config,projectStore,styles}){return{
 async project(req,res){const file=path.basename(req.params.fileName);if(file!==req.params.fileName)throw new AppError('INVALID_PATH','Invalid asset path',{status:400});let source;if(projectStore.findAsset)source=(await projectStore.findAsset(req.params.projectId,req.params.type,file,{ownerId:req.auth.tenantId})).sourcePath;else{await projectStore.read(req.params.projectId,{ownerId:req.auth.tenantId});source=path.join(projectStore.assetDir(req.params.projectId,req.params.type),file);}if(!fs.existsSync(source))throw new AppError('ASSET_NOT_FOUND','Asset not found',{status:404});res.sendFile(source);},
 style(req,res){const file=path.basename(req.params.fileName);if(file!==req.params.fileName)throw new AppError('INVALID_PATH','Invalid reference path',{status:400});const source=path.join(styles.referenceDir(req.params.styleId,req.params.type),file);if(!fs.existsSync(source))throw new AppError('ASSET_NOT_FOUND','Reference asset not found',{status:404});res.sendFile(source);}
};}
module.exports={createAssetsController};
