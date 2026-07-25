const { pipeline } = require('node:stream/promises');

function createStylesController({ styles, imageProvider }){
  return {
    async list(req,res){
      res.json({styles:await styles.listAvailable(req.auth?.userId)});
    },
    async references(req,res){
      const id=req.params.styleId;
      if(!await styles.resolve(id,req.auth?.userId))return res.status(404).json({error:'Unknown style'});
      res.json({styleId:id,references:await styles.resolveReferences(id,req.auth?.userId)});
    },
    upload(req,res){
      const id=styles.sanitize(req.params.styleId);
      res.json({ok:true,styleId:id,references:styles.upload(id,req.query.type||req.body.type,req.files,req.auth?.userId)});
    },
    remove(req,res){
      const id=styles.sanitize(req.params.styleId);
      const deleteFile = req.query.deleteFile === 'true' || req.body.deleteFile === true;
      res.json({ok:true,styleId:id,references:styles.remove(id,req.body.type,req.body.fileName,req.auth?.userId,deleteFile)});
    },
    activate(req,res){
      const id=styles.sanitize(req.params.styleId);
      res.json({ok:true,styleId:id,references:styles.activate(id,req.body.type,req.body.fileName,req.auth?.userId)});
    },
    async customList(req,res){
      res.json({styles:await styles.listCustom(req.auth.userId)});
    },
    async customCreate(req,res){
      res.status(201).json({style:await styles.createCustom(req.auth.userId,req.body)});
    },
    async customUpdate(req,res){
      res.json({style:await styles.updateCustom(req.params.styleId,req.auth.userId,req.body)});
    },
    async customArchive(req,res){
      res.json({style:await styles.archiveCustom(req.params.styleId,req.auth.userId)});
    },
    async customReferences(req,res){
      res.json({styleId:req.params.styleId,references:await styles.resolveReferences(req.params.styleId,req.auth.userId)});
    },
    async customReferenceUpload(req,res){
      res.status(201).json({styleId:req.params.styleId,references:await styles.uploadCustomReferences(req.params.styleId,req.query.type||req.body.type,req.files,req.auth.userId)});
    },
    async customReferenceRemove(req,res){
      res.json({styleId:req.params.styleId,references:await styles.removeCustomReference(req.params.styleId,req.params.referenceId,req.auth.userId)});
    },
    async customReferenceOrder(req,res){
      res.json({styleId:req.params.styleId,references:await styles.reorderCustomReferences(req.params.styleId,req.body.type,req.body.ids||[],req.auth.userId)});
    },
    async customReferenceGenerate(req,res){
      const idempotencyKey = req.headers['x-idempotency-key'] || req.body.idempotencyKey;
      res.status(201).json({styleId:req.params.styleId,references:await styles.generateCustomReference(req.params.styleId,req.body.type,req.body.provider,req.auth.userId,{imageProvider,idempotencyKey})});
    },
    async customReferenceContent(req,res){
      const {reference,stream}=await styles.customReferenceStream(req.params.styleId,req.params.referenceId,req.auth.userId);
      res.type(reference.mimeType);
      try {
        await pipeline(stream,res);
      } catch (err) {
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
      }
    }
  };
}
module.exports={createStylesController};
