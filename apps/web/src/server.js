function startServer(app,config){return app.listen(config.port,()=>console.log(`Storyboard POC running on http://localhost:${config.port}`));}module.exports={startServer};
