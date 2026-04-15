import { Router, type IRouter } from "express";
import healthRouter from "./health";
import policiesRouter from "./policies";

const router: IRouter = Router();

router.use(healthRouter);
router.use(policiesRouter);

export default router;
