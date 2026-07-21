function createMediaController({images,audio,videos,subtitles,exports}){return{
 async image(req,res){res.json({ok:true,...await images.generate(req.body,{ownerId:req.auth.tenantId,userId:req.auth.userId,signal:req.generationSignal,jobId:req.generationJobId})});},
 async imagePreflight(req,res){res.json({ok:true,...await images.preflight(req.body,{ownerId:req.auth.tenantId,userId:req.auth.userId})});},
 async audio(req,res){res.json({ok:true,...await audio.generate(req.body,{ownerId:req.auth.tenantId,userId:req.auth.userId,signal:req.generationSignal,jobId:req.generationJobId})});},
 async audioRecording(req,res){res.json({ok:true,...await audio.uploadRecording(req.body,req.file,{ownerId:req.auth.tenantId,userId:req.auth.userId,signal:req.generationSignal,jobId:req.generationJobId})});},
 async video(req,res){res.json({ok:true,...await videos.generate(req.body,{ownerId:req.auth.tenantId,userId:req.auth.userId,signal:req.generationSignal,jobId:req.generationJobId})});},
 async videoPreflight(req,res){res.json(await videos.verify({provider:req.query.provider,model:req.query.model,generationMode:req.query.generationMode}));},
 async videoAttemptStatus(req,res){res.json({ok:true,attempt:await videos.attemptStatus(req.params.attemptId,{ownerId:req.auth.tenantId})});},
 async subtitle(req,res){res.json({ok:true,...await subtitles.generate(req.body,{ownerId:req.auth.tenantId,userId:req.auth.userId,signal:req.generationSignal,jobId:req.generationJobId})});},
 async export(req,res){res.json({ok:true,...await exports.generate(req.body.projectId,{ownerId:req.auth.tenantId,userId:req.auth.userId})});}
};}
module.exports={createMediaController};
