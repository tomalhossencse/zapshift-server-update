const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SCREET);

const port = process.env.PORT || 3000;

const crypto = require("crypto");

const admin = require("firebase-admin");

const serviceAccount = require("./zapshift-update-fb-sdk.json");
const { count } = require("console");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const generateTrackingId = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `ZAP-${date}-${random}`;
};

// middleware
app.use(express.json());
app.use(cors());

// verify with fbtoken

const verifyFbToken = async (req, res, next) => {
  // console.log("header in middlewares : ", req.headers.authorization);
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized acces" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    // console.log("decode in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vybtxro.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection

    // db and collections
    const db = client.db("zapShiftUpdate");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const userCollection = db.collection("users");
    const riderCollection = db.collection("riders");
    const trackingCollection = db.collection("trackings");

    //  middleware admin before allowing admin acitivity
    //  must be used after verifyFbToken middleware

    const verfiyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };
    const verfiyRider = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split("_").join(" "),
        createAt: new Date(),
      };

      const result = await trackingCollection.insertOne(log);
      return result;
    };

    // users related apis

    app.get("/users", verifyFbToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        // query.displayName = { $regex: searchText, $options: "i" };
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      const result = await userCollection
        .find(query)
        .sort({ createAt: -1 })
        .limit(3)
        .toArray();
      res.send(result);
    });

    app.get("/users/:id", async (req, res) => {});

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.patch("/users/:id", verifyFbToken, verfiyAdmin, async (req, res) => {
      const id = req.params.id;
      const role = req.body.role;
      const query = { _id: new ObjectId(id) };
      const updateDocs = {
        $set: {
          role: role,
        },
      };
      const result = await userCollection.updateOne(query, updateDocs);
      res.send(result);
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createAt = new Date();
      const email = user.email;
      const userExist = await userCollection.findOne({ email });

      if (userExist) {
        return res.send({ message: "users exists" });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // parcel apis

    app.get("/parcels", verifyFbToken, async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createAt: -1 } };
      //   parcels?email=&
      const result = await parcelCollection.find(query, options).toArray();
      res.send(result);
    });

    app.get("/parcels/rider", verifyFbToken, async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }
      if (deliveryStatus !== "parcel_delivered") {
        // query.deliveryStatus = { $in: ["rider-assigned", "rider-arriving"] };
        query.deliveryStatus = { $nin: ["parcel_delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }

      const result = await parcelCollection
        .find(query)
        .sort({ createAt: -1 })
        .toArray();
      res.send(result);
    });

    // get single parcels

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    app.get("/parcels/delivery-status/stats", async (req, res) => {
      const pipline = [
        {
          $group: {
            _id: "$deliveryStatus",
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            // _id: 0,
          },
        },
      ];

      const result = await parcelCollection.aggregate(pipline).toArray();
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;

      const trackingId = generateTrackingId();
      parcel.trackingId = trackingId;

      logTracking(trackingId, "parcel_created");

      const resullt = await parcelCollection.insertOne(parcel);
      res.send(resullt);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const resullt = await parcelCollection.deleteOne(query);
      res.send(resullt);
    });

    app.patch("/parcels/:id", async (req, res) => {
      const { riderName, riderEmail, riderId, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          deliveryStatus: "rider_assigned",
          riderId,
          riderName,
          riderEmail,
        },
      };
      await parcelCollection.updateOne(query, updateDoc);

      // update rider information

      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };
      const riderResult = await riderCollection.updateOne(
        riderQuery,
        riderUpdatedDoc,
      );
      // log tracking
      logTracking(trackingId, "rider_assigned");

      res.send(riderResult);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId, trackingId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updatedDoc = {
        $set: {
          deliveryStatus,
        },
      };

      // update rider information
      if (deliveryStatus === "parcel_delivered") {
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdatedDoc = {
          $set: {
            workStatus: "available",
          },
        };
        await riderCollection.updateOne(riderQuery, riderUpdatedDoc);
      }
      const result = await parcelCollection.updateOne(query, updatedDoc);
      // log tracking

      logTracking(trackingId, deliveryStatus);
      res.send(result);
    });

    // rider apis

    app.get("/riders", async (req, res) => {
      const query = {};
      const options = { sort: { createAt: -1 } };

      const { status, picupWarhouse, workStatus } = req.query;
      if (status) {
        query.status = status;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      if (picupWarhouse) {
        query.picupWarhouse = picupWarhouse;
      }
      const result = await riderCollection.find(query, options).toArray();
      res.send(result);
    });

    app.get("/riders/delivery-per-day", async (req, res) => {
      const email = req.query.email;

      // aggregate on parcel

      const pipline = [
        {
          $match: {
            riderEmail: email,
            deliveryStatus: "parcel_delivered",
          },
        },

        {
          $lookup: {
            from: "trackings",
            localField: "trackingId",
            foreignField: "trackingId",
            as: "parcel_trackings",
          },
        },
        {
          $unwind: "$parcel_trackings",
        },
        {
          $match: {
            "parcel_trackings.status": "parcel_delivered",
          },
        },

        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$parcel_trackings.createAt", // tracking date field
              },
            },
            totalDelivery: { $sum: 1 },
          },
        },
      ];

      const result = await parcelCollection.aggregate(pipline).toArray();

      res.send(result);
    });

    app.patch("/riders/:id", verifyFbToken, verfiyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const status = req.body.status;
      const update = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };
      const result = await riderCollection.updateOne(query, update);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: { role: "rider" },
        };

        await userCollection.updateOne(userQuery, updateUser);
      }

      res.send(result);
    });

    app.delete("/riders/:id", verifyFbToken, verfiyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await riderCollection.deleteOne(query);

      res.send(result);
    });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createAt = new Date();

      const result = await riderCollection.insertOne(rider);
      res.send(result);
    });

    // payment related apis

    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "BDT",
              unit_amount: amount,
              product_data: {
                name: `please pay for :  ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
          trackingId: paymentInfo.trackingId,
        },
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const session_id = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(session_id);

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);

      // console.log(paymentExist);

      if (paymentExist) {
        return res.send({
          message: "payments exits",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }
      // use the previous tracking id created during the parcel created which was set to the session meta data during session creation
      // const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const trackingId = session.metadata.trackingId;
        const id = session.metadata.parcelId;

        const query = { _id: new ObjectId(id) };

        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending_pickup",
          },
        };

        const result = await parcelCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        const resultPayment = await paymentCollection.insertOne(payment);

        logTracking(trackingId, "pending_pickup");

        return res.send({
          success: true,
          modifyPayment: result,
          paymentInfo: resultPayment,
          trackingId: trackingId,
          transactionId: session.payment_intent,
        });
      }

      // console.log("session retrive data :", session);

      return res.send({ success: false });
    });

    // old

    // app.post("/create-checkout-session", async (req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;
    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         price_data: {
    //           currency: "BDT",
    //           unit_amount: amount,
    //           product_data: {
    //             name: paymentInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],

    //     customer_email: paymentInfo.senderEmail,
    //     metadata: {
    //       parcelId: paymentInfo.parcelId,
    //     },
    //     mode: "payment",
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    //   });
    //   console.log(session);
    //   res.send({ url: session.url });
    // });

    // payment related apis

    app.get("/payments", verifyFbToken, async (req, res) => {
      const email = req.query.email;

      const query = {};

      if (email) {
        query.customerEmail = email;

        // cheack email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }
      }

      const result = await paymentCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    // tracking related apis

    app.get("/trackings/:trackingId/logs", async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingCollection
        .find(query)
        .sort({ createAt: -1 })
        .toArray();
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "❤️Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zapshift Server is Running..............");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
