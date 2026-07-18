const express=require('express');
const {asyncRoute}=require('./helpers');
function stylesRoutes({controller,upload}){
  const router=express.Router();
  router.get('/',asyncRoute(controller.list));
  router.get('/:styleId/references',asyncRoute(controller.references));
  router.post('/:styleId/references/upload',upload.array('files',8),asyncRoute(controller.upload));
  router.delete('/:styleId/references',asyncRoute(controller.remove));
  router.post('/:styleId/references/activate',asyncRoute(controller.activate));
  return router;
}
module.exports={stylesRoutes};
