function createStylesController({ styles }){
  return {
    list(req,res){
      res.json({styles:styles.list(req.auth?.userId)});
    },
    references(req,res){
      const id=styles.sanitize(req.params.styleId);
      if(!styles.find(id))return res.status(404).json({error:'Unknown style'});
      res.json({styleId:id,references:styles.references(id,req.auth?.userId)});
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
    }
  };
}
module.exports={createStylesController};
