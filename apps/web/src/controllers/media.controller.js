function createMediaController({images,audio,videos,exports}){return{
 async image(req,res){res.json({ok:true,...await images.generate(req.body,{ownerId:req.auth.tenantId,userId:req.auth.userId,signal:req.generationSignal,jobId:req.generationJobId})});},
 async audio(req,res){res.json({ok:true,...await audio.generate(req.body,{ownerId:req.auth.tenantId,userId:req.auth.userId,signal:req.generationSignal,jobId:req.generationJobId})});},
 async video(req,res){res.json({ok:true,...await videos.generate(req.body,{ownerId:req.auth.tenantId,userId:req.auth.userId,signal:req.generationSignal,jobId:req.generationJobId})});},
 async videoPreflight(req,res){res.json(await videos.verify());},
 async export(req,res){res.json({ok:true,...await exports.generate(req.body.projectId,{ownerId:req.auth.tenantId,userId:req.auth.userId})});}
};}
module.exports={createMediaController};
